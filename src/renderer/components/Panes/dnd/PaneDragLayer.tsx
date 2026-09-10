import React from 'react';
import { PaneDragState } from './types';
import { useTabTitleColor, titleColorStyle } from '../../../store/titleColor';

/** A small translucent ghost of the dragged pane's title that follows the cursor. */
export const PaneDragLayer: React.FC<{ drag: PaneDragState }> = ({ drag }) => {
  // The ghost IS the pane's title in flight, so it keeps the colour the title had. Taken from the
  // SOURCE tab: the pane still belongs to it until the drop commits, and colouring by the tab
  // under the cursor would announce a regrouping that has not happened yet.
  const titleColor = useTabTitleColor(drag.source.sourceTabId);
  return (
    <div
      className="pane-drag-ghost"
      style={{
        position: 'fixed',
        left: drag.pointer.x + 12,
        top: drag.pointer.y + 12,
        zIndex: 100000,
        pointerEvents: 'none',
        ...titleColorStyle(titleColor),
      }}
    >
      {drag.source.name || 'Terminal'}
    </div>
  );
};
