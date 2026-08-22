import React from 'react';
import {
  CanvasGroupModel, counterScale, labelScale, labelMaxWidth, LABEL_TOP, LABEL_LEFT,
} from './canvasSelectors';
import { drawnFrameRect } from './canvasLayout';
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
  /** Where this chip sits relative to its group's own corner, in WORLD units — the nudge that
   *  keeps collapsed chips off each other (`groupChips.chipOffsets`). Absent means no nudge. */
  chipOffset?: { dx: number; dy: number };
  /** A node is being dragged over this frame and would re-home into it on release. */
  dropTarget?: boolean;
  /** This frame is itself being dragged, with its terminals. */
  moving?: boolean;
  onLabelPointerDown?: (e: React.PointerEvent) => void;
  onChipClick?: () => void;
  /**
   * Right-click on the group's HANDLE — its label, or its chip once collapsed.
   *
   * Deliberately not on the frame itself. The frame is a real box rather than a
   * `pointer-events: none` outline, so it covers the canvas background across the whole interior
   * of the group; a menu there would shadow the background's own "New terminal here" menu
   * everywhere a group sits, which is the larger target and the one that spawns terminals.
   */
  onContextMenu?: (e: React.MouseEvent) => void;
}> = ({
  group, zoom, collapsed, chipOffset, dropTarget, moving,
  onLabelPointerDown, onChipClick, onContextMenu,
}) => {
  const { x, y } = group.rect;
  const { zMax } = useCanvasMetrics();

  if (collapsed) {
    return (
      <div
        className="canvas-gchip"
        data-tab-id={group.tabId}
        // The offset is applied to the world POSITION rather than to the transform, so the
        // counter-scale stays a pure `scale()` about the chip's own corner. Folding a
        // translate into the transform would scale the nudge too, and the layout computed it
        // in screen units on purpose.
        style={{
          left: x + (chipOffset?.dx ?? 0),
          top: y + (chipOffset?.dy ?? 0),
          transform: `scale(${counterScale(zoom, zMax)})`,
          transformOrigin: '0 0',
        }}
        onClick={onChipClick}
        onContextMenu={onContextMenu}
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

  // What the frame PAINTS, which is not quite what the layout reserved: the padding between a
  // terminal and its frame is a screen distance to the eye, so it is clamped into a screen band
  // rather than left to scale with the world. See `drawnFrameRect`. Nothing moves — the
  // terminals stay on their layout rects and only the border around them breathes.
  const box = drawnFrameRect(group.rect, zoom);

  return (
    <div
      className={['canvas-gframe', dropTarget ? 'drop' : '', moving ? 'moving' : '']
        .filter(Boolean).join(' ')}
      data-tab-id={group.tabId}
      style={{ left: box.x, top: box.y, width: box.w, height: box.h }}
    >
      {/* `labelScale`, NOT `counterScale`: a label is a world-space element, so an uncapped
          counter-scale gives it an unbounded world footprint — measured at 110x900 units on a
          372-wide frame at z=0.1, which is how it ended up printed across the group above it.
          `maxWidth` bounds the other axis, which no scale ceiling can. */}
      {(() => {
        const k = labelScale(zoom, zMax);
        return (
          <span
            className="canvas-glabel"
            style={{
              top: LABEL_TOP * k,
              left: LABEL_LEFT * k,
              transform: `scale(${k})`,
              maxWidth: labelMaxWidth(box.w, k),
            }}
            onPointerDown={onLabelPointerDown}
            onContextMenu={onContextMenu}
            // Carries the full title as well as the hint, because the label now ellipsises.
            title={`${group.title} — drag to move this group and all its terminals, right-click to rename`}
          >
            {group.title}
          </span>
        );
      })()}
    </div>
  );
};

export default CanvasGroupFrame;
