import React, { useCallback, useMemo, useRef } from 'react';
import { Rect, Viewport, screenToWorld } from './canvasGeometry';
import { boundsOf } from './viewportStyles';
import {
  minimapTransform, minimapRect, minimapToWorld, minimapPanStep, minimapToScreen,
} from './orientation';
import { panShortcut, exceedsDragSlop } from './canvasGestures';
import type { CanvasModel } from './canvasSelectors';

/**
 * The workspace, shrunk into a corner (`plan/013` Task 23, design 010 §10 "deep zoom out").
 *
 * **This is also where the tab strip's click-to-fly went.** Design §5.1's resolution keeps the
 * strip's passive half — the nearest-group marker — and moves navigation onto surfaces the canvas
 * owns, because a tab click already means "switch to that tab" and must keep meaning it. So
 * clicking the minimap is not a bonus: it is the affordance D9 asked for, in the one place it can
 * live without redefining a control the rest of the app shares.
 *
 * Sized here rather than in `Canvas.css` on purpose. The box's dimensions are an INPUT to
 * `minimapTransform`, so a copy of them in the stylesheet would be a second source of truth for
 * the projection — and the failure would be silent, a minimap whose contents no longer fill it.
 */

export const MINIMAP_W = 168;
export const MINIMAP_H = 112;

/** The "you are here" rectangle. A constant rather than a literal in the handler, because
 *  `CanvasViewport` keeps its own selectors in named constants for the same reason: a selector
 *  spelled out at the point of use is a string nothing checks against the class it names. */
const VIEW_RECT = '.canvas-miniview';

export const CanvasMinimap: React.FC<{
  model: CanvasModel;
  vp: Viewport;
  vw: number;
  vh: number;
  /** A world point the user aimed at. The caller owns the flight, since it owns the zoom. */
  onPick: (world: { x: number; y: number }) => void;
  /** One arrow-key step, already converted to SCREEN pixels — the unit `panBy` takes, and the
   *  same unit the canvas's own arrow keys speak, so the parent has one pan path rather than
   *  two. The SIZE of the step is this component's to decide, because only it holds the
   *  projection the step is measured against. */
  onPan?: (dxScreen: number, dyScreen: number) => void;
}> = ({ model, vp, vw, vh, onPick, onPan }) => {
  // The viewport's own world rect. Derived through `screenToWorld` rather than by inverting the
  // transform by hand, so it cannot disagree with the pan/zoom maths everything else uses.
  const view: Rect = useMemo(() => {
    const a = screenToWorld(vp, 0, 0);
    const b = screenToWorld(vp, vw, vh);
    return { x: a.x, y: a.y, w: b.x - a.x, h: b.y - a.y };
  }, [vp, vw, vh]);

  /**
   * The viewport rect is part of the BOUNDS, not just drawn inside them.
   *
   * Fitting only the content would push the "you are here" rectangle outside the box — and
   * `overflow: hidden` then clips it away entirely — exactly when the user has panned off into
   * empty space and most needs to see where they are. The cost is that the scale changes as you
   * pan out past the content, which is what every canvas minimap does.
   */
  const t = useMemo(() => {
    const bounds = boundsOf([...model.groups.map((g) => g.rect), view]);
    return minimapTransform(bounds ?? view, MINIMAP_W, MINIMAP_H);
  }, [model.groups, view]);

  /** The world point drawn under a client-space pointer. */
  const worldAt = useCallback((el: HTMLDivElement, cx: number, cy: number) => {
    const r = el.getBoundingClientRect();
    return minimapToWorld(t, cx - r.left, cy - r.top);
  }, [t]);

  /**
   * A drag of the view rectangle (Tam, 2026-08-17: *"the blue rectangle is not draggable"*).
   *
   * `x`/`y` are the last position the pan was measured from, `sx`/`sy` where the press landed.
   * Both are needed: deltas come from the LAST move so the rectangle keeps the grab offset it
   * was picked up with, while the slop that decides click-versus-drag is measured from the
   * START — a threshold reset on every move is never crossed by a slow drag.
   */
  const drag = useRef<{ x: number; y: number; sx: number; sy: number; moved: boolean } | null>(null);

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    // Taken explicitly rather than left to the browser's default focusing of a `tabIndex`
    // element: clicking the minimap and then using the arrows is the whole way into its
    // keyboard mode, and a default that any later `preventDefault` would silently cancel is
    // not something to hang a feature on.
    e.currentTarget.focus();
    // A press ON the rectangle is a drag; anywhere else it is the fly-to it has always been.
    // Deliberately NOT both: `onPick` animates over `FLY_MS`, and a flight dispatching a
    // viewport a frame at a time from a start it captured before the drag began would
    // overwrite every pan the drag made until it finished.
    if (onPan && (e.target as Element | null)?.closest?.(VIEW_RECT)) {
      drag.current = { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, moved: false };
      e.currentTarget.setPointerCapture(e.pointerId);
      return;
    }
    onPick(worldAt(e.currentTarget, e.clientX, e.clientY));
  }, [onPan, onPick, worldAt]);

  /**
   * `t` is read LIVE rather than frozen at pointerdown, because it is what the rectangle is
   * currently drawn with — a frozen copy would pan by one scale while the user watched another.
   * The cost is that dragging out past the content changes `k` mid-gesture (the viewport rect is
   * part of the bounds, see above), so the rectangle lags the cursor slightly out there. Inside
   * the content — every normal drag — the bounds do not move and it tracks exactly.
   */
  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || !onPan) return;
    if (!d.moved && !exceedsDragSlop(e.clientX - d.sx, e.clientY - d.sy)) return;
    d.moved = true;
    onPan(
      minimapToScreen(t, vp.z, e.clientX - d.x),
      minimapToScreen(t, vp.z, e.clientY - d.y),
    );
    d.x = e.clientX;
    d.y = e.clientY;
  }, [onPan, t, vp.z]);

  /**
   * A press on the rectangle that never moved is still a CLICK, and it still flies.
   *
   * Without this the drag would shadow the fly-to over its own area — and that area is not
   * small: the viewport rect is part of the minimap's bounds, so at a wide zoom-out it covers
   * nearly the whole box and "click to fly there" would quietly stop working exactly where the
   * user can see the most to aim at.
   */
  const onPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    if (!d.moved) onPick(worldAt(e.currentTarget, e.clientX, e.clientY));
  }, [onPick, worldAt]);

  /** A cancelled pointer is not a click — the gesture was taken away, not completed. */
  const onPointerCancel = useCallback(() => {
    drag.current = null;
  }, []);

  /**
   * The minimap's own arrows (Tam's item 3).
   *
   * A React handler on the element, so it only runs while the minimap actually HAS the keyboard
   * — which is exactly the condition that separates these arrows from the canvas's. `CanvasMode`
   * listens on the window in the capture phase and so would otherwise run first and pan by its
   * own step as well; it bails on any event inside `.canvas-minimap` for that reason.
   */
  const onKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!onPan) return;
    const dir = panShortcut(e as unknown as Parameters<typeof panShortcut>[0]);
    if (!dir) return;
    e.preventDefault();
    const step = minimapPanStep(t, vp.z);
    onPan(dir.dx * step, dir.dy * step);
  }, [onPan, t, vp.z]);

  const box = (r: Rect): React.CSSProperties => {
    const m = minimapRect(t, r);
    return { left: m.x, top: m.y, width: m.w, height: m.h };
  };

  return (
    <div
      className="canvas-minimap"
      style={{ width: MINIMAP_W, height: MINIMAP_H }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onKeyDown={onKeyDown}
      // Focusable, because the arrows above are only reachable by something that can hold the
      // keyboard. `role="application"` rather than the `presentation` this carried while it was
      // click-only: presentation on a focusable element hides a control that IS in the tab order,
      // and application is what tells a screen reader to hand the arrow keys through instead of
      // using them to walk the document.
      tabIndex={0}
      role="application"
      aria-label="Workspace minimap — click to fly there, drag the view box to pan, arrow keys to pan"
      title="Click to fly there · drag the view box to pan · arrow keys to pan"
    >
      {model.groups.map((g) => (
        <div key={g.tabId} className="canvas-minigroup" style={box(g.rect)} />
      ))}
      {model.nodes.map((n) => (
        <div
          key={n.terminalId}
          className={`canvas-mininode${n.isRunning ? ' running' : ''}`}
          style={box(n.rect)}
        />
      ))}
      <div className="canvas-miniview" style={box(view)} />
    </div>
  );
};

export default CanvasMinimap;
