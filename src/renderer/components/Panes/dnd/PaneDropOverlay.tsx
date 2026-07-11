import React from 'react';
import { PaneDropTarget } from './types';

/** Highlight rectangle for the half/region a drop will occupy, given the zone. */
function regionStyle(target: PaneDropTarget): React.CSSProperties {
  switch (target.zone) {
    case 'left':
      return { left: 0, top: 0, width: '50%', height: '100%' };
    case 'right':
      return { left: '50%', top: 0, width: '50%', height: '100%' };
    case 'top':
      return { left: 0, top: 0, width: '100%', height: '50%' };
    case 'bottom':
      return { left: 0, top: '50%', width: '100%', height: '50%' };
    case 'center':
    default:
      return { left: 0, top: 0, width: '100%', height: '100%' };
  }
}

/** iTerm2-style edge-zone highlight, positioned over the target pane (viewport coords). */
export const PaneDropOverlay: React.FC<{ target: PaneDropTarget }> = ({ target }) => {
  const { rect } = target;
  return (
    <div
      className="pane-drop-overlay"
      style={{
        position: 'fixed',
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
        zIndex: 99999,
        pointerEvents: 'none',
      }}
    >
      <div className="pane-drop-overlay__region" style={{ position: 'absolute', ...regionStyle(target) }} />
    </div>
  );
};
