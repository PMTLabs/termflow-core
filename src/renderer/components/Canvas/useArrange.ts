import { useCallback, useEffect, useRef } from 'react';
import { useDispatch } from 'react-redux';
import { applyArrange } from '../../store/slices/canvasSlice';
import type { CanvasModel } from './canvasSelectors';
import type { ArrangeEdge } from './canvasArrange';
import {
  ARRANGE_MS, arrangeTarget, currentLayout, easeOutCubic, interpolateArrange,
} from './animateLayout';

/**
 * The Arrange button's behaviour — `plan/013` Task 13, design 010 §6.4 / D10.
 *
 * A hook rather than more of `CanvasMode` for the same reason `useCanvasDrag` is one: what is
 * left after the decisions move into pure functions is a requestAnimationFrame lifecycle, and
 * that has three failure modes (a loop outliving its component, two loops fighting, a loop that
 * stops short of its target) which are much easier to see when they are the only thing in the
 * file.
 *
 * Deliberately mirrors `useFlyTo` — same clamp, same reduced-motion escape, same
 * cancel-before-restart. Design 010 §9 requires reduced motion of fly-to and Arrange alike, and
 * two animations on this surface that behaved differently under it would be a bug the user only
 * ever hit on one of them.
 */
export function useArrange(model: CanvasModel, edges: readonly ArrangeEdge[] = []): () => void {
  const dispatch = useDispatch();
  const raf = useRef<number | null>(null);

  // Read through a ref so the returned callback keeps a stable identity: the model changes on
  // every dispatch in the app, and a new function each time would re-render the toolbar
  // continuously — including on the ~26 dispatches this very animation makes.
  const latest = useRef(model);
  latest.current = model;

  // Same ref, same reason. The wires decide the ORDER Arrange fills its slots in
  // (`optimiseArrangeOrder`), so they have to be current at the moment of the press — and
  // `canvas.edges` is replaced wholesale by `setEdges`, so a dependency on it would be one more
  // thing re-creating this callback.
  const latestEdges = useRef(edges);
  latestEdges.current = edges;

  // A run in progress when the canvas tab closes would keep dispatching into an unmounted tree.
  useEffect(() => () => {
    if (raf.current) cancelAnimationFrame(raf.current);
    raf.current = null;
  }, []);

  return useCallback(() => {
    // Pressing Arrange twice must not leave two loops interpolating from two different starts
    // toward the same target — they would fight frame by frame and read as jitter.
    if (raf.current) cancelAnimationFrame(raf.current);
    raf.current = null;

    const to = arrangeTarget(latest.current, latestEdges.current);
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      dispatch(applyArrange(to));
      return;
    }

    // Captured AFTER the cancel above, so a second press starts from wherever the first had
    // actually got to rather than from where it began.
    const from = currentLayout(latest.current);
    const t0 = performance.now();
    const step = (now: number) => {
      const k = Math.min(1, (now - t0) / ARRANGE_MS);
      // The final frame dispatches `to` ITSELF rather than a blend evaluated at 1.
      //
      // Redundant on its own — `interpolateArrange`'s lerp is already exact at its endpoints —
      // and deliberately kept anyway, because the two together are what make "Arrange lands on
      // the grid" hold no matter which one is edited next. Mutating either alone leaves the
      // property intact; mutating both breaks it, and `useArrange.test.tsx` pins that pair.
      dispatch(applyArrange(k < 1 ? interpolateArrange(from, to, easeOutCubic(k)) : to));
      if (k < 1) {
        raf.current = requestAnimationFrame(step);
        return;
      }
      raf.current = null;
    };
    raf.current = requestAnimationFrame(step);
  }, [dispatch]);
}

export default useArrange;
