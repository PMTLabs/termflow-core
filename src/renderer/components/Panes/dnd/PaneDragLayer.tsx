import React from 'react';
import { PaneDragState } from './types';

/** A small translucent ghost of the dragged pane's title that follows the cursor. */
export const PaneDragLayer: React.FC<{ drag: PaneDragState }> = ({ drag }) => {
  return (
    <div
      className="pane-drag-ghost"
      style={{
        position: 'fixed',
        left: drag.pointer.x + 12,
        top: drag.pointer.y + 12,
        zIndex: 100000,
        pointerEvents: 'none',
      }}
    >
      {drag.source.name || 'Terminal'}
    </div>
  );
};
