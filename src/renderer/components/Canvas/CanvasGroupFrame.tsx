import React from 'react';
import { CanvasGroupModel, counterScale } from './canvasSelectors';
import { useCanvasMetrics } from './canvasMetricsContext';

/**
 * A tab, drawn as a frame around its terminals — or, once the whole workspace has
 * collapsed past the chip tier, as a single chip standing in for the tab.
 *
 * Both the label and the chip counter-scale, so they keep a constant on-screen size
 * however far the canvas is zoomed out. The chip is the ONLY thing legible at that
 * zoom, which is why it counter-scales as a whole element rather than just its text.
 */
export const CanvasGroupFrame: React.FC<{
  group: CanvasGroupModel;
  zoom: number;
  collapsed: boolean;
  onLabelPointerDown?: (e: React.PointerEvent) => void;
  onChipClick?: () => void;
}> = ({ group, zoom, collapsed, onLabelPointerDown, onChipClick }) => {
  const { x, y, w, h } = group.rect;
  const { zMax } = useCanvasMetrics();

  if (collapsed) {
    return (
      <div
        className="canvas-gchip"
        data-tab-id={group.tabId}
        style={{ left: x, top: y, transform: `scale(${counterScale(zoom, zMax)})`, transformOrigin: '0 0' }}
        onClick={onChipClick}
        title={`Zoom in to ${group.title}`}
      >
        <span className="canvas-gchip-title">{group.title}</span>
        <span className="canvas-gchip-count">
          {group.nodeIds.length} {group.nodeIds.length === 1 ? 'terminal' : 'terminals'}
        </span>
        {group.anyRunning && <span className="canvas-gchip-run" />}
      </div>
    );
  }

  return (
    <div className="canvas-gframe" data-tab-id={group.tabId} style={{ left: x, top: y, width: w, height: h }}>
      <span
        className="canvas-glabel"
        style={{ transform: `scale(${counterScale(zoom, zMax)})` }}
        onPointerDown={onLabelPointerDown}
        title="Drag to move this group and all its terminals"
      >
        {group.title}
      </span>
    </div>
  );
};

export default CanvasGroupFrame;
