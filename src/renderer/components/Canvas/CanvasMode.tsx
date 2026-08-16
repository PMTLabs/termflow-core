import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { terminalCache } from '@termflow/terminal-core';
import { RootState } from '../../store';
import { focusNode, selectNode } from '../../store/slices/canvasSlice';
import { focusPaneInTab } from '../../store/slices/panesSlice';
import { setActiveTab } from '../../store/slices/tabsSlice';
import { CanvasViewport, useFlyTo } from './CanvasViewport';
import { CanvasGroupFrame } from './CanvasGroupFrame';
import { CanvasNode } from './CanvasNode';
import { NodeTerminal } from './NodeTerminal';
import {
  Rect, assignTiers, NODE_W, NODE_H, HEAD_H, HOST_W, HOST_H, SURFACE_SCALE, FOCUS_ZOOM,
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

  useCanvasRenderPolicy(tiers, focusedId, recent);

  const clearSelection = useCallback(() => {
    dispatch(selectNode(null));
    dispatch(focusNode(null));
  }, [dispatch]);

  // Double-click a node BODY to hand keystrokes to its terminal. Single click is
  // selection (gesture-precedence row 4), and nothing else focuses a terminal on canvas —
  // the engine's own click-to-focus is not wired in chromeless mode, and D19's pointer
  // gate keeps xterm's always-on mousedown from reaching `term.element`.
  const focusRaf = useRef<number | null>(null);
  const focusTerminal = useCallback((terminalId: string, rect: Rect) => (e: React.MouseEvent) => {
    if (!(e.target as HTMLElement).closest('.canvas-node-body')) return;
    // Fly to the 1:1 scale and hand over input only ON ARRIVAL. xterm 6 does not divide
    // pointer deltas by an ancestor transform, so a click during the flight lands on the
    // wrong cell — and lifting the gate early is what makes that reachable.
    //
    // FOCUS_ZOOM, not 1: the surface is scaled DOWN into the node, so the zoom at which the
    // terminal renders 1:1 is HOST_W / NODE_W, not unity.
    flyTo(centreOn(rect, size.w, size.h, FOCUS_ZOOM), () => {
      dispatch(focusNode(terminalId));
      // A frame later, so the gate has lifted with `focused` and the textarea is
      // reachable. Tracked, because leaving Canvas Mode inside that frame would
      // otherwise pull focus into a terminal that is already back in its pane.
      if (focusRaf.current) cancelAnimationFrame(focusRaf.current);
      focusRaf.current = requestAnimationFrame(() => {
        focusRaf.current = null;
        terminalCache.get(terminalId)?.terminal.focus();
      });
    });
  }, [dispatch, flyTo, size]);

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
      // Esc is a legitimate PTY key that xterm delivers while its textarea holds focus,
      // so blur it before restoring the gate, or the gesture never reaches the canvas.
      (document.activeElement as HTMLElement | null)?.blur();
      dispatch(focusNode(null));
    };
    // Capture phase, matching InputHandler's ownership of global shortcuts.
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [focusedId, dispatch]);

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
        {model.nodes.map((n) => {
          const tier = tiers[n.terminalId] ?? 'group';
          return (
            <CanvasNode
              key={n.terminalId}
              node={n}
              tier={tier}
              zoom={vp.z}
              selected={selectedId === n.terminalId}
              focused={focusedId === n.terminalId}
              // Fed in Task 18, once edges exist to compute a neighbourhood from.
              dimmed={false}
              hidden={collapsed || tier === 'group' || !visible.has(n.terminalId)}
              onPointerDown={() => dispatch(selectNode(n.terminalId))}
              onDoubleClick={focusTerminal(n.terminalId, n.rect)}
              onChipClick={() => flyTo(centreOn(n.rect, size.w, size.h, NODE_CHIP_ZOOM))}
              onOpenAsTab={openAsTab(n.tabId, n.paneId)}
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
