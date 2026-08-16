import React, { useCallback, useMemo, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { RootState } from '../../store';
import { focusNode, selectNode } from '../../store/slices/canvasSlice';
import { CanvasViewport, useFlyTo } from './CanvasViewport';
import { CanvasGroupFrame } from './CanvasGroupFrame';
import { CanvasNode } from './CanvasNode';
import { Rect, assignTiers } from './canvasGeometry';
import { centreOn } from './viewportStyles';
import {
  selectCanvasModel, visibleNodeIds, allCollapsed,
  GROUP_CHIP_ZOOM, NODE_CHIP_ZOOM,
} from './canvasSelectors';
import './Canvas.css';

/**
 * Canvas Mode surface. Rendered as a sibling of the tab-mode terminal container
 * and shown only when `canvas.enabled` — design 010 D1: this is a lens over the
 * same state, so the tab-mode DOM stays mounted underneath.
 *
 * Node bodies are static here; Task 9 fills them with live terminals. Every node in
 * the workspace is rendered for the whole session regardless of tier or culling —
 * see the note on `CanvasNode` for why that is load-bearing rather than wasteful.
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

  const clearSelection = useCallback(() => {
    dispatch(selectNode(null));
    dispatch(focusNode(null));
  }, [dispatch]);

  return (
    <div className="canvas-mode" data-testid="canvas-mode">
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
              onChipClick={() => flyTo(centreOn(n.rect, size.w, size.h, NODE_CHIP_ZOOM))}
            />
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
