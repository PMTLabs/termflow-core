import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { RootState } from '../../store';
import { setViewport, panViewport } from '../../store/slices/canvasSlice';
import { Viewport, zoomAt } from './canvasGeometry';
import { useCanvasMetrics } from './canvasMetricsContext';
import { gridStyle, worldStyle, lerpViewport, FLY_MS } from './viewportStyles';
import {
  shouldArmSpacePan, shouldDisarmSpacePan, wheelAction, wheelPanDelta, CanvasWheelMode,
} from './canvasGestures';

/**
 * Everything on the canvas that is a TARGET rather than background.
 *
 * `.canvas-gchip` is here because it is a click target — omitting it would start a pan on the
 * one gesture that is supposed to fly in. The minimap and the beacons are here for exactly the
 * same reason: both are aimed at, and without this a click on either would also grab the canvas
 * and clear the selection.
 *
 * The three wire entries are the same rule applied to a connection. `.canvas-wire-hit` is the
 * band a click selects the wire in, and a selection cleared by the very press that made it is
 * a wire that cannot be selected at all; `.canvas-wire-handle` and `.canvas-wire-badge` are the
 * controls that appear once it is.
 *
 * One constant, shared by the pan and the background context menu, because "did this land on
 * empty canvas?" has to have one answer. Two copies would drift the day a surface is added —
 * and the copy that was not updated fails silently, as a pan that starts under a new control
 * or a menu that opens on top of one.
 */
const BACKGROUND_BAIL =
  '.canvas-node, .canvas-gchip, .canvas-glabel, .canvas-port, .canvas-minimap, .canvas-beacon,'
  + ' .canvas-wire-hit, .canvas-wire-handle, .canvas-wire-badge';

const isBackground = (target: EventTarget | null): boolean =>
  !(target as HTMLElement | null)?.closest(BACKGROUND_BAIL);

/**
 * A node, and the terminal it is showing — the other question this file asks the DOM.
 *
 * Kept in named constants beside `BACKGROUND_BAIL` rather than spelled out inside the handler,
 * so every selector this component depends on is in one place and a class rename has one
 * grep-able answer. The attribute is `CanvasNode`'s, and `orientationWiring.test.ts` holds the
 * rule that nothing here passes a bare literal to `closest`.
 */
const NODE = '.canvas-node';
const NODE_TERMINAL_ATTR = 'data-terminal-id';

const terminalIdAt = (target: EventTarget | null): string | null =>
  (target as HTMLElement | null)?.closest(NODE)?.getAttribute(NODE_TERMINAL_ATTR) ?? null;

/**
 * Pan/zoom host. Which gesture the wheel is belongs to `wheelAction` and to the user's
 * `canvasWheelMode` setting — by default the wheel zooms the canvas and Ctrl+wheel is left
 * completely alone so it keeps its existing meaning (font zoom in the terminal under the
 * pointer, design 010 §4.1); set to `'scroll'` the wheel pans and the chord zooms the canvas.
 */
export const CanvasViewport: React.FC<{
  children?: React.ReactNode;
  /** Reports the viewport's size in CSS pixels. LOD tiers and paint culling are both
   *  computed against it, so it has to be the real measured box, not the window. */
  onSize?: (w: number, h: number) => void;
  /** A pointerdown that landed on the canvas background rather than on any node,
   *  chip, port or group label. */
  onBackgroundPointerDown?: () => void;
  /** A right-click on that same background. Shares `BACKGROUND_BAIL`'s definition of
   *  "background" with the pan, so the two cannot disagree about what is empty canvas. */
  onBackgroundContextMenu?: (e: React.MouseEvent) => void;
  /**
   * Screen-space chrome, rendered INSIDE this element and OUTSIDE `.canvas-world` —
   * so it neither pans nor zooms, but is positioned in VIEWPORT coordinates.
   *
   * That distinction is the reason this slot exists rather than the caller placing the chrome
   * beside `<CanvasViewport>`. `.canvas-mode` is a flex row whose first child is the sidebar, so
   * its origin is ~255px left of the viewport's; anything positioned by a computed `left`/`top`
   * from `worldToScreen` — which returns viewport coordinates, because `onSize` measures this
   * element — lands under the sidebar. `.canvas-toolbar` gets away with living out there only
   * because it is anchored `right`, where the two frames coincide.
   */
  overlay?: React.ReactNode;
}> = ({ children, onSize, onBackgroundPointerDown, onBackgroundContextMenu, overlay }) => {
  const dispatch = useDispatch();
  const vp = useSelector((s: RootState) => s.canvas.viewport);
  const ref = useRef<HTMLDivElement>(null);
  const pan = useRef<{ x: number; y: number } | null>(null);

  // Keep a ref of the viewport so the native wheel listener below always reads the
  // current value without re-subscribing on every pan. Declared BEFORE the effect
  // that closes over it.
  const vpRef = useRef(vp);
  vpRef.current = vp;

  // Same reason as `vpRef`: the wheel listener is attached natively, once, and must not be
  // torn down and re-registered to learn the session's zoom ceiling. The ceiling is frozen for
  // the session anyway (see `canvasMetrics`), so a ref is exact rather than merely convenient.
  const zMaxRef = useRef(useCanvasMetrics().zMax);

  // Read through a ref for the same reason: the wheel listener is registered once, and
  // re-registering it every time the overlay opened would drop a wheel mid-gesture.
  const overlayIdRef = useRef<string | null>(null);
  overlayIdRef.current = useSelector((s: RootState) => s.canvas.overlayId);

  // The wheel mapping, and the terminal holding the keyboard. Same refs-not-deps reason as
  // above — and `focusedId` in particular changes on every click, which would otherwise tear
  // the listener down and rebuild it mid-scroll.
  const wheelModeRef = useRef<CanvasWheelMode>('zoom');
  wheelModeRef.current = useSelector((s: RootState) => s.settings.canvasWheelMode);
  const focusedId = useSelector((s: RootState) => s.canvas.focusedId);
  const focusedIdRef = useRef<string | null>(null);
  focusedIdRef.current = focusedId;

  // React attaches wheel listeners at the root PASSIVELY, so preventDefault() inside
  // a synthetic onWheel is a no-op and logs a console error. Attach natively instead —
  // the same thing `useSurfaceZoom` already does for the existing font-zoom gesture.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      // The RULE is in `canvasGestures`, testable without a DOM; this owns only the wiring.
      // `passthrough` leaves the event completely alone — no preventDefault, no stopPropagation
      // — so it reaches the terminal it belongs to.
      const focused = focusedIdRef.current;
      const action = wheelAction(e, {
        overlayId: overlayIdRef.current,
        mode: wheelModeRef.current,
        onFocusedTerminal: !!focused && terminalIdAt(e.target) === focused,
      });
      if (action === 'passthrough') return;
      e.preventDefault();
      e.stopPropagation();
      if (action === 'pan') {
        // Relative, so this never reads the viewport — and so a scroll and an arrow key reach
        // the store by the same path, with `panBy` owning the one sign inversion between them.
        const { dx, dy } = wheelPanDelta(e);
        dispatch(panViewport({ dx, dy }));
        return;
      }
      const r = el.getBoundingClientRect();
      dispatch(setViewport(
        zoomAt(vpRef.current, Math.pow(0.9989, e.deltaY), e.clientX - r.left, e.clientY - r.top, zMaxRef.current)
      ));
    };
    // CAPTURE, for the reason above: the terminals are descendants, so this is the only phase
    // that can run before them. The two early returns are equally deliberate — Ctrl+wheel and
    // an open overlay both leave the event alone so it reaches the terminal it belongs to.
    el.addEventListener('wheel', onWheel, { passive: false, capture: true });
    return () => el.removeEventListener('wheel', onWheel, { capture: true } as EventListenerOptions);
  }, [dispatch]);

  // Measure the real box rather than the window: a sidebar (Task 15) makes the two
  // differ, and every tier decision is keyed on this. `useLayoutEffect` so the first
  // measurement lands BEFORE paint — a frame reported at 0x0 would put every node
  // off-screen and briefly demote the whole canvas to `snapshot`.
  const lastSize = useRef({ w: -1, h: -1 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !onSize) return;
    const report = () => {
      const r = el.getBoundingClientRect();
      if (r.width === lastSize.current.w && r.height === lastSize.current.h) return;
      lastSize.current = { w: r.width, h: r.height };
      onSize(r.width, r.height);
    };
    report();
    const ro = new ResizeObserver(report);
    ro.observe(el);
    return () => ro.disconnect();
  }, [onSize]);

  /**
   * Hold Space to pan from anywhere — the hand tool every canvas app has, Photoshop included.
   *
   * Without it, a node covers its own patch of canvas: press on one and you select it, so
   * there is nothing to drag and a dense workspace has no background left to grab.
   *
   * The RULES live in `canvasGestures` so they can be tested without a DOM; this owns only the
   * wiring — capture phase, pointer capture, the `.space-pan` class.
   *
   * Cleared on blur as well as keyup: a keyup that lands on another window never arrives, and
   * the state would stick until the next press. Alt+Tab away mid-pan and back, and the canvas
   * would be permanently in hand mode with no key held.
   */
  const [spacePan, setSpacePan] = useState(false);
  const spacePanRef = useRef(false);
  spacePanRef.current = spacePan;
  // `focusedId` is selected above, with the wheel's refs — this effect wants the VALUE (it
  // re-registers when the focus changes), the wheel wants a ref. One selector serves both.

  useEffect(() => {
    const arm = (e: KeyboardEvent) => {
      if (!shouldArmSpacePan(e as unknown as Parameters<typeof shouldArmSpacePan>[0], focusedId)) return;
      e.preventDefault();                          // Space also scrolls a page by default
      setSpacePan(true);
    };
    const disarm = (e: KeyboardEvent) => {
      if (!shouldDisarmSpacePan(e)) return;
      setSpacePan(false);
    };
    const clear = () => setSpacePan(false);
    // Capture phase, matching InputHandler's ownership of global keys.
    window.addEventListener('keydown', arm, true);
    window.addEventListener('keyup', disarm, true);
    window.addEventListener('blur', clear);
    return () => {
      window.removeEventListener('keydown', arm, true);
      window.removeEventListener('keyup', disarm, true);
      window.removeEventListener('blur', clear);
    };
  }, [focusedId]);

  // Releasing Space mid-drag must not leave the pointer captured and the canvas following the
  // mouse with nothing held.
  useEffect(() => {
    if (!spacePan && pan.current) endPanRef.current();
  }, [spacePan]);

  const startPan = useCallback((e: React.PointerEvent) => {
    pan.current = { x: e.clientX - vpRef.current.x, y: e.clientY - vpRef.current.y };
    ref.current?.setPointerCapture(e.pointerId);
    ref.current?.classList.add('panning');
  }, []);

  /**
   * CAPTURE phase, which is the whole point: a node's own `pointerdown` is on a DESCENDANT, so
   * a bubble-phase handler here would run after the node had already selected itself. This
   * runs first and stops the event before it reaches anything.
   */
  const onPointerDownCapture = useCallback((e: React.PointerEvent) => {
    if (!spacePanRef.current) return;
    e.preventDefault();
    e.stopPropagation();
    startPan(e);
  }, [startPan]);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    if (pan.current) return;                     // already panning, via Space
    if (isBackground(e.target)) {
      onBackgroundPointerDown?.();
      startPan(e);
    }
  }, [onBackgroundPointerDown, startPan]);

  /**
   * Right-click on empty canvas — the "create a terminal here" menu (Tam's item 3).
   *
   * A node stops its own contextmenu, so this never sees one; the bail list is still needed
   * for everything that does NOT have a handler of its own — a group chip, a group label, the
   * minimap, a beacon — where a "new terminal here" menu would be answering a question about a
   * different thing entirely.
   */
  const onContextMenu = useCallback((e: React.MouseEvent) => {
    if (!onBackgroundContextMenu || !isBackground(e.target)) return;
    e.preventDefault();
    onBackgroundContextMenu(e);
  }, [onBackgroundContextMenu]);

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
  // Read through a ref by the Space effect above, which must not re-register on every
  // re-creation of `endPan`.
  const endPanRef = useRef(endPan);
  endPanRef.current = endPan;

  return (
    <div
      ref={ref}
      className={`canvas-viewport${spacePan ? ' space-pan' : ''}`}
      onPointerDownCapture={onPointerDownCapture}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endPan}
      onPointerCancel={endPan}
      onContextMenu={onContextMenu}
    >
      <div className="canvas-grid" style={gridStyle(vp)} />
      <div className="canvas-world" style={worldStyle(vp)}>{children}</div>
      {overlay}
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

  // `onDone` fires when the viewport has ARRIVED — including immediately under reduced
  // motion. Task 9 needs it: xterm 6 does not divide pointer deltas by an ancestor
  // `transform: scale()`, so input handed over mid-flight lands on the wrong cells.
  // A caller counting FLY_MS on its own timer would get the reduced-motion case wrong
  // and would have to keep its own copy of the duration.
  return useCallback((to: Viewport, onDone?: () => void) => {
    if (raf.current) cancelAnimationFrame(raf.current);
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      dispatch(setViewport(to));
      onDone?.();
      return;
    }
    const from = vpRef.current;
    const t0 = performance.now();
    const step = (now: number) => {
      const k = Math.min(1, (now - t0) / FLY_MS);
      dispatch(setViewport(lerpViewport(from, to, k)));
      if (k < 1) {
        raf.current = requestAnimationFrame(step);
        return;
      }
      // Cleared BEFORE the callback: `onDone` may start another flight, and clearing
      // after would null out the handle that flight just stored.
      raf.current = null;
      onDone?.();
    };
    raf.current = requestAnimationFrame(step);
  }, [dispatch]);
}

export default CanvasViewport;
