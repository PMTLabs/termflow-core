import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { terminalCache } from '@termflow/terminal-core';
import { runningActivityTracker } from '../../services/RunningActivityTracker';
import { RootState } from '../../store';
import { focusNode, selectNode, setOverlayNode } from '../../store/slices/canvasSlice';
import { focusPaneInTab } from '../../store/slices/panesSlice';
import { setActiveTab } from '../../store/slices/tabsSlice';
import { CanvasViewport, useFlyTo } from './CanvasViewport';
import { CanvasGroupFrame } from './CanvasGroupFrame';
import { CanvasNode } from './CanvasNode';
import { NodeTerminal } from './NodeTerminal';
import { NodeSnapshot } from './NodeSnapshot';
import { snapshotCache } from './snapshotCache';
import {
  Rect, assignTiers, overlayGeometry, canvasMetrics, headScale, chromeScale,
  NODE_W, NODE_H, HEAD_H,
} from './canvasGeometry';
import { CanvasMetricsContext } from './canvasMetricsContext';
import { measureHostBox, clearHostBoxes } from './canvasHostBoxes';
import { useCanvasDrag } from './useCanvasDrag';
import { centreOn } from './viewportStyles';
import { useCanvasRenderPolicy } from './useCanvasRenderPolicy';
import {
  selectCanvasModel, visibleNodeIds, allCollapsed, snapshotNodeIds,
  GROUP_CHIP_ZOOM, NODE_CHIP_ZOOM,
} from './canvasSelectors';
import './Canvas.css';

/** The node geometry the stylesheet needs, as CSS variables rather than numbers repeated in
 *  Canvas.css. The host half is per-session — see `canvasMetrics` — so this is built from the
 *  frozen metrics rather than being a module constant. */
const geometryVars = (
  m: { hostW: number; hostH: number; surfaceScale: number },
  zoom: number,
) => ({
  '--canvas-node-w': `${NODE_W}px`,
  '--canvas-node-h': `${NODE_H}px`,
  '--canvas-head-h': `${HEAD_H}px`,
  '--canvas-host-w': `${m.hostW}px`,
  '--canvas-host-h': `${m.hostH}px`,
  '--canvas-surface-scale': `${m.surfaceScale}`,
  // The two counter-scales. Published ONCE at the root rather than inline on every node,
  // because both are functions of the zoom alone — nothing about them is per-node. That is
  // also what lets a GROUP FRAME use `--node-chrome-k`: frames are siblings of nodes, not
  // children, so a node-level variable could never have reached them, and the frame's border
  // was the one piece of canvas chrome still growing with the zoom.
  '--node-k': `${headScale(zoom)}`,
  '--node-chrome-k': `${chromeScale(zoom)}`,
}) as React.CSSProperties;

/**
 * Canvas Mode surface — the body of the canvas TAB.
 *
 * `TerminalContainer` mounts this only while that tab is active, so entering and leaving
 * the canvas is a tab switch. Every other tab stays mounted (hidden) throughout, which is
 * what lets terminals be handed back when you switch away. This amends design 010 D1,
 * which specified a full-surface overlay; see `backlog/007` §4.
 *
 * Every node in the workspace is rendered, and hosts a live terminal, for the whole
 * session regardless of tier or culling — see the note on `CanvasNode` for why that is
 * load-bearing rather than wasteful. Render policy is applied centrally by
 * `useCanvasRenderPolicy`, never per node.
 */
export const CanvasMode: React.FC = () => {
  const dispatch = useDispatch();
  const model = useSelector(selectCanvasModel);
  const vp = useSelector((s: RootState) => s.canvas.viewport);
  const selectedId = useSelector((s: RootState) => s.canvas.selectedId);
  const focusedId = useSelector((s: RootState) => s.canvas.focusedId);
  const overlayId = useSelector((s: RootState) => s.canvas.overlayId);
  const recent = useSelector((s: RootState) => s.canvas.recent);
  const [size, setSize] = useState({ w: 0, h: 0 });

  // FROZEN FOR THE SESSION, and the two things about that are both load-bearing.
  //
  // WHY it is per-session: the host box is also the box the overlay renders at 1:1, and one
  // constant cannot serve a 1366-wide laptop and a 4K panel — sized for one, the other gets
  // either a half-empty overlay or a half-size font. `canvasMetrics` sizes it from the display.
  //
  // WHY it is frozen: it IS the CSS box a live terminal is fitted to. Changing it while
  // terminals are relocated in is a `fit()`, a `term.resize()` and a SIGWINCH into every
  // ratatui/codex PTY on the canvas (`012` §6.5 RC2). A `useState` initialiser runs ONCE per
  // mount, during the first render — before any child registers a host — which is exactly the
  // window this has to land in. Do not turn this into a `useMemo` on `size`: that is the same
  // code with the guarantee removed, and it would re-evaluate on every window resize.
  //
  // Measured from the window rather than the canvas element because the element has not been
  // laid out yet at this point. It only picks the box; the overlay's own fit uses the real
  // measured viewport, so an approximation here costs nothing.
  const [metrics] = useState(() => canvasMetrics(
    typeof window === 'undefined' ? 1920 : window.innerWidth,
    typeof window === 'undefined' ? 1040 : window.innerHeight,
  ));
  const flyTo = useFlyTo();

  const onSize = useCallback((w: number, h: number) => setSize({ w, h }), []);

  const tiers = useMemo(() => {
    const rects: Record<string, Rect> = {};
    for (const n of model.nodes) rects[n.terminalId] = n.rect;
    return assignTiers({
      ids: model.nodes.map((n) => n.terminalId),
      rects,
      vp,
      vw: size.w,
      vh: size.h,
      focusedId,
      recent,
    });
  }, [model, vp, size, focusedId, recent]);

  const visible = useMemo(
    () => visibleNodeIds(model.nodes, vp, size.w, size.h),
    [model, vp, size],
  );

  const collapsed = allCollapsed(model.nodes, tiers);

  // At the snapshot tier, on screen, and not swallowed by a whole-canvas collapse. The rule
  // lives in `canvasSelectors` so it can be tested — see `snapshotNodeIds` for why the
  // intersection with `visible` is load-bearing rather than an optimisation.
  const snapshotIds = useMemo(
    () => snapshotNodeIds(model.nodes, tiers, visible, collapsed),
    [model.nodes, tiers, visible, collapsed],
  );

  // Keep the cache to what is actually on screen. Snapshots are cheap to refetch, and an entry
  // per terminal in a large workspace is a screen's worth of ANSI each.
  useEffect(() => {
    snapshotCache.evictAllBut(Array.from(snapshotIds));
  }, [snapshotIds]);

  // Each terminal's own host box, captured from its PANE (`plan/017`).
  //
  // Read during RENDER, deliberately, because this is the only moment the question still has
  // the right answer: React renders a parent before its children, `NodeTerminal` registers its
  // host in a ref callback during the commit, and `useSurfaceRelocation`'s layout effect moves
  // `term.element` after that. By the time any effect runs, `term.element.parentElement` is the
  // canvas host and measuring it would measure our own replica. `measureHostBox` caches on the
  // first call and refuses to measure a container inside `.canvas-surface`, so both the double
  // render of StrictMode and a mistimed call are inert.
  const hostBoxes = useMemo(() => {
    const out: Record<string, { w: number; h: number }> = {};
    for (const n of model.nodes) {
      out[n.terminalId] = measureHostBox(n.terminalId, { w: metrics.hostW, h: metrics.hostH });
    }
    return out;
  }, [model.nodes, metrics]);

  // Frozen boxes outlive their session otherwise, and the next one may open on a different
  // window size, split layout or font.
  useEffect(() => () => clearHostBoxes(), []);

  // Recomputed from the viewport, so the overlay stays screen-centred while the canvas pans
  // and zooms underneath it rather than sliding away with the world.
  //
  // Sized from the OVERLAID TERMINAL's box, not the session's: under `plan/017` decision C the
  // overlay is that terminal at its actual size, so an unsplit tab's terminal fills the screen
  // and a quarter-split's fills a quarter. `surfaceScale` is recomputed from the same box so the
  // "not smaller than an ordinary node" floor inside `overlayGeometry` stays meaningful.
  const overlay = useMemo(() => {
    if (!overlayId) return null;
    const b = hostBoxes[overlayId];
    if (!b) return null;
    return overlayGeometry(vp, size.w, size.h, {
      hostW: b.w, hostH: b.h, surfaceScale: NODE_W / b.w,
    });
  }, [overlayId, vp, size, hostBoxes]);

  useCanvasRenderPolicy(tiers, focusedId, recent);

  // Node drag, group drag and cross-group re-homing (Tasks 11 + 12).
  const drag = useCanvasDrag(model);

  // Both edges of the canvas session relocate every terminal between two differently-sized
  // boxes, which SIGWINCHes every PTY and makes every TUI repaint. Without this the repaint
  // reads as real activity: the running sweep fires across the whole tab strip and a
  // notification pops, for output the user caused by switching to a tab.
  //
  // A layout effect, so the window is armed before the relocation the child hosts trigger can
  // produce anything; the cleanup covers the return trip the same way.
  useLayoutEffect(() => {
    runningActivityTracker.notifyViewChangeBurst();
    return () => runningActivityTracker.notifyViewChangeBurst();
  }, []);

  const clearSelection = useCallback(() => {
    dispatch(selectNode(null));
    dispatch(focusNode(null));
  }, [dispatch]);

  // Double-click a node BODY to open it as the full-screen overlay.
  //
  // It used to fly the viewport to `FOCUS_ZOOM` and hand over the keyboard in place. That is
  // gone with the zoom ladder (see `FOCUS_ZOOM`): the canvas now stops short of 1:1, so there
  // is no longer a canvas zoom at which a click lands on the right cell — xterm 6 does not
  // divide pointer deltas by an ancestor transform. The overlay renders at exactly 1:1, so it
  // is both the bigger rung and the only one where input is correct. Nothing was lost:
  // typing in place was only ever accurate at that single zoom.
  const focusTerminal = useCallback((terminalId: string) => (e: React.MouseEvent) => {
    if (!(e.target as HTMLElement).closest('.canvas-node-body')) return;
    dispatch(setOverlayNode(terminalId));
  }, [dispatch]);

  // A frame after the overlay opens, so the pointer gate has lifted with `focused` and the
  // textarea is reachable. Tracked, because leaving Canvas Mode inside that frame would
  // otherwise pull focus into a terminal that is already back in its pane.
  const focusRaf = useRef<number | null>(null);
  useEffect(() => {
    if (!overlayId) return;
    if (focusRaf.current) cancelAnimationFrame(focusRaf.current);
    focusRaf.current = requestAnimationFrame(() => {
      focusRaf.current = null;
      terminalCache.get(overlayId)?.terminal.focus();
    });
  }, [overlayId]);

  // Leaving the canvas hands input back. This used to be a side effect of
  // `setCanvasEnabled(false)`; with the canvas a tab, the mode can be left in ways that
  // never reach a canvas action at all — a click in the tab strip, Ctrl+Tab, closing the
  // tab — so the unmount itself is the only reliable place to clear it. A stale
  // `focusedId` would keep granting a node the `gpu` tier (design 010 D8) from a canvas
  // nobody is looking at.
  useEffect(() => () => {
    if (focusRaf.current) cancelAnimationFrame(focusRaf.current);
    focusRaf.current = null;
    dispatch(focusNode(null));
    dispatch(setOverlayNode(null));
  }, [dispatch]);

  // Leave the canvas for the tab this node lives in, with the cursor on its own pane.
  // `focusPaneInTab` before `setActiveTab`, because the activation path RESTORES the
  // tab's remembered pane — writing `activePaneId` directly would be overwritten.
  const openAsTab = useCallback((tabId: string, paneId: string) => () => {
    dispatch(focusPaneInTab({ tabId, paneId }));
    dispatch(setActiveTab(tabId));
  }, [dispatch]);

  useEffect(() => {
    if (!focusedId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // Esc unwinds one layer at a time. Closing the overlay AND releasing the keyboard on a
      // single press would leave no way to shrink a node and keep typing in it.
      if (overlayIdRef.current) {
        dispatch(setOverlayNode(null));
        return;
      }
      // Esc is a legitimate PTY key that xterm delivers while its textarea holds focus,
      // so blur it before restoring the gate, or the gesture never reaches the canvas.
      (document.activeElement as HTMLElement | null)?.blur();
      dispatch(focusNode(null));
    };
    // Capture phase, matching InputHandler's ownership of global shortcuts.
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [focusedId, dispatch]);

  // Read through a ref inside the Esc handler above: that effect is keyed on `focusedId`, and
  // adding `overlayId` to its deps would tear down and re-register the capture-phase listener
  // every time the overlay opened or closed.
  const overlayIdRef = useRef<string | null>(null);
  overlayIdRef.current = overlayId;

  return (
    <CanvasMetricsContext.Provider value={metrics}>
    <div className="canvas-mode" data-testid="canvas-mode" style={geometryVars(metrics, vp.z)}>
      <CanvasViewport onSize={onSize} onBackgroundPointerDown={clearSelection}>
        {model.groups.map((g) => (
          <CanvasGroupFrame
            key={g.tabId}
            group={g}
            zoom={vp.z}
            collapsed={collapsed}
            dropTarget={drag.dropTabId === g.tabId}
            moving={drag.movingTabId === g.tabId}
            onLabelPointerDown={drag.onGroupLabelPointerDown(g.tabId)}
            onChipClick={() => flyTo(centreOn(g.rect, size.w, size.h, GROUP_CHIP_ZOOM, metrics.zMax))}
          />
        ))}
        {overlay && (
          // World-space, not screen-space: `.canvas-world` sets `will-change: transform` and
          // is therefore a stacking context, so a backdrop outside it could never sit between
          // the ordinary nodes and the overlaid one.
          <div
            className="canvas-overlay-backdrop"
            style={{
              left: overlay.backdrop.x, top: overlay.backdrop.y,
              width: overlay.backdrop.w, height: overlay.backdrop.h,
            }}
            onPointerDown={(e) => { e.stopPropagation(); dispatch(setOverlayNode(null)); }}
          />
        )}
        {model.nodes.map((n) => {
          const isOverlaid = overlay !== null && n.terminalId === overlayId;
          // The overlaid node is the SAME node with a different world rect — no second host,
          // no relocation, no fit. See `overlayGeometry`.
          const node = isOverlaid ? { ...n, rect: overlay!.rect } : n;
          const tier = isOverlaid ? 'gpu' : (tiers[n.terminalId] ?? 'group');
          return (
            <CanvasNode
              key={n.terminalId}
              node={node}
              tier={tier}
              zoom={vp.z}
              selected={selectedId === n.terminalId}
              focused={focusedId === n.terminalId}
              // Fed in Task 18, once edges exist to compute a neighbourhood from.
              dimmed={false}
              // Culling reads the node's ORIGINAL rect, which for an overlaid node can be far
              // off screen — the overlay would then be hidden the moment you opened it.
              hidden={!isOverlaid && (collapsed || tier === 'group' || !visible.has(n.terminalId))}
              overlaid={isOverlaid}
              hostBox={hostBoxes[n.terminalId]}
              onPointerDown={() => dispatch(selectNode(n.terminalId))}
              // The ORIGINAL rect, never the overlay's: dragging an overlaid node would
              // otherwise start from a screen-filling box and fling it across the world.
              onHeaderPointerDown={isOverlaid ? undefined : drag.onNodeHeaderPointerDown(n.terminalId, n.tabId, n.rect)}
              onDoubleClick={focusTerminal(n.terminalId)}
              onChipClick={() => flyTo(centreOn(n.rect, size.w, size.h, NODE_CHIP_ZOOM, metrics.zMax))}
              onOpenAsTab={openAsTab(n.tabId, n.paneId)}
              onOpenOverlay={() => dispatch(setOverlayNode(isOverlaid ? null : n.terminalId))}
            >
              {/* RC4: mounted for EVERY node, at every tier, for the whole canvas
                  session. The tier ladder and the cull margin decide what a node
                  PAINTS; they never decide where `term.element` lives. */}
              <NodeTerminal terminalId={n.terminalId} focused={focusedId === n.terminalId} />
              {/* The exact opposite rule, and for the exact opposite reason: this one is
                  culled hard, because what it owns is a timer rather than a terminal. */}
              {snapshotIds.has(n.terminalId) && <NodeSnapshot terminalId={n.terminalId} />}
            </CanvasNode>
          );
        })}
      </CanvasViewport>
      {!model.nodes.length && !model.groups.length && (
        <div className="canvas-empty">No terminals yet</div>
      )}
    </div>
    </CanvasMetricsContext.Provider>
  );
};

export default CanvasMode;
