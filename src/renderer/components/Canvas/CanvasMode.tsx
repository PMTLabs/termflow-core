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
import {
  Rect, assignTiers, overlayGeometry, NODE_W, NODE_H, HEAD_H, HOST_W, HOST_H, SURFACE_SCALE,
} from './canvasGeometry';
import { centreOn } from './viewportStyles';
import { useCanvasRenderPolicy } from './useCanvasRenderPolicy';
import {
  selectCanvasModel, visibleNodeIds, allCollapsed,
  GROUP_CHIP_ZOOM, NODE_CHIP_ZOOM,
} from './canvasSelectors';
import './Canvas.css';

/** The node geometry the stylesheet needs. Passed as CSS variables rather than repeated
 *  in Canvas.css: the terminal host's box is derived from these and must stay in step
 *  with the world box the nodes are laid out on. */
const GEOMETRY_VARS = {
  '--canvas-node-w': `${NODE_W}px`,
  '--canvas-node-h': `${NODE_H}px`,
  '--canvas-head-h': `${HEAD_H}px`,
  '--canvas-host-w': `${HOST_W}px`,
  '--canvas-host-h': `${HOST_H}px`,
  '--canvas-surface-scale': `${SURFACE_SCALE}`,
} as React.CSSProperties;

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

  // Recomputed from the viewport, so the overlay stays screen-centred while the canvas pans
  // and zooms underneath it rather than sliding away with the world.
  const overlay = useMemo(
    () => (overlayId ? overlayGeometry(vp, size.w, size.h) : null),
    [overlayId, vp, size],
  );

  useCanvasRenderPolicy(tiers, focusedId, recent);

  // Both edges of the canvas session relocate every terminal between two differently-sized
  // boxes, which SIGWINCHes every PTY and makes every TUI repaint. Without this the repaint
  // reads as real activity: the running sweep fires across the whole tab strip and a
  // notification pops, for output the user caused by switching to a tab.
  //
  // A layout effect, so the window is armed before the relocation the child hosts trigger can
  // produce anything; the cleanup covers the return trip the same way.
  useLayoutEffect(() => {
    runningActivityTracker.notifyRelocationBurst();
    return () => runningActivityTracker.notifyRelocationBurst();
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
    <div className="canvas-mode" data-testid="canvas-mode" style={GEOMETRY_VARS}>
      <CanvasViewport onSize={onSize} onBackgroundPointerDown={clearSelection}>
        {model.groups.map((g) => (
          <CanvasGroupFrame
            key={g.tabId}
            group={g}
            zoom={vp.z}
            collapsed={collapsed}
            onChipClick={() => flyTo(centreOn(g.rect, size.w, size.h, GROUP_CHIP_ZOOM))}
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
              onPointerDown={() => dispatch(selectNode(n.terminalId))}
              onDoubleClick={focusTerminal(n.terminalId)}
              onChipClick={() => flyTo(centreOn(n.rect, size.w, size.h, NODE_CHIP_ZOOM))}
              onOpenAsTab={openAsTab(n.tabId, n.paneId)}
              onOpenOverlay={() => dispatch(setOverlayNode(isOverlaid ? null : n.terminalId))}
            >
              {/* RC4: mounted for EVERY node, at every tier, for the whole canvas
                  session. The tier ladder and the cull margin decide what a node
                  PAINTS; they never decide where `term.element` lives. */}
              <NodeTerminal terminalId={n.terminalId} focused={focusedId === n.terminalId} />
            </CanvasNode>
          );
        })}
      </CanvasViewport>
      {!model.nodes.length && !model.groups.length && (
        <div className="canvas-empty">No terminals yet</div>
      )}
    </div>
  );
};

export default CanvasMode;
