import React from 'react';
import './Canvas.css';

/**
 * Canvas Mode surface. Rendered as a sibling of the tab-mode terminal container
 * and shown only when `canvas.enabled` — design 010 D1: this is a lens over the
 * same state, so the tab-mode DOM stays mounted underneath.
 */
export const CanvasMode: React.FC = () => (
  <div className="canvas-mode" data-testid="canvas-mode">
    <div className="canvas-viewport">
      <div className="canvas-empty">Canvas Mode</div>
    </div>
  </div>
);

export default CanvasMode;
