import React, { useCallback, useEffect, useRef } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { RootState } from '../../store';
import { setViewport } from '../../store/slices/canvasSlice';
import { Viewport, zoomAt } from './canvasGeometry';
import { gridStyle, worldStyle, lerpViewport, FLY_MS } from './viewportStyles';

/**
 * Pan/zoom host. Plain wheel zooms the canvas; Ctrl+wheel is deliberately NOT
 * intercepted so it keeps its existing meaning (font zoom inside a focused
 * terminal) — see design 010 §4.1.
 */
export const CanvasViewport: React.FC<{ children?: React.ReactNode }> = ({ children }) => {
  const dispatch = useDispatch();
  const vp = useSelector((s: RootState) => s.canvas.viewport);
  const ref = useRef<HTMLDivElement>(null);
  const pan = useRef<{ x: number; y: number } | null>(null);

  // Keep a ref of the viewport so the native wheel listener below always reads the
  // current value without re-subscribing on every pan. Declared BEFORE the effect
  // that closes over it.
  const vpRef = useRef(vp);
  vpRef.current = vp;

  // React attaches wheel listeners at the root PASSIVELY, so preventDefault() inside
  // a synthetic onWheel is a no-op and logs a console error. Attach natively instead —
  // the same thing `useSurfaceZoom` already does for the existing font-zoom gesture.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) return; // Ctrl+wheel stays font zoom
      e.preventDefault();
      const r = el.getBoundingClientRect();
      dispatch(setViewport(
        zoomAt(vpRef.current, Math.pow(0.9989, e.deltaY), e.clientX - r.left, e.clientY - r.top)
      ));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [dispatch]);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest('.canvas-node, .canvas-glabel, .canvas-port')) return;
    pan.current = { x: e.clientX - vpRef.current.x, y: e.clientY - vpRef.current.y };
    ref.current?.setPointerCapture(e.pointerId);
    ref.current?.classList.add('panning');
  }, []);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!pan.current) return;
    dispatch(setViewport({
      ...vpRef.current,
      x: e.clientX - pan.current.x,
      y: e.clientY - pan.current.y,
    }));
  }, [dispatch]);

  const endPan = useCallback(() => {
    pan.current = null;
    ref.current?.classList.remove('panning');
  }, []);

  return (
    <div
      ref={ref}
      className="canvas-viewport"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endPan}
      onPointerCancel={endPan}
    >
      <div className="canvas-grid" style={gridStyle(vp)} />
      <div className="canvas-world" style={worldStyle(vp)}>{children}</div>
    </div>
  );
};

/**
 * Animate the viewport to `to` over FLY_MS, easing out. Honours reduced motion by
 * jumping straight there — design 010 §9 requires this of fly-to as well as Arrange.
 *
 * Shared deliberately: Tasks 14, 18 and 23 all need animated viewport flight, and
 * without one helper each would invent an incompatible curve and duration.
 */
export function useFlyTo() {
  const dispatch = useDispatch();
  const raf = useRef<number | null>(null);
  const vpRef = useRef<Viewport>({ x: 0, y: 0, z: 1 });
  vpRef.current = useSelector((s: RootState) => s.canvas.viewport);

  // A flight in progress when the canvas closes would keep dispatching viewport
  // updates into an unmounted tree.
  useEffect(() => () => {
    if (raf.current) cancelAnimationFrame(raf.current);
    raf.current = null;
  }, []);

  return useCallback((to: Viewport) => {
    if (raf.current) cancelAnimationFrame(raf.current);
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      dispatch(setViewport(to));
      return;
    }
    const from = vpRef.current;
    const t0 = performance.now();
    const step = (now: number) => {
      const k = Math.min(1, (now - t0) / FLY_MS);
      dispatch(setViewport(lerpViewport(from, to, k)));
      raf.current = k < 1 ? requestAnimationFrame(step) : null;
    };
    raf.current = requestAnimationFrame(step);
  }, [dispatch]);
}

export default CanvasViewport;
