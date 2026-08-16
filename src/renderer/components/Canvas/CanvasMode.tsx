import React from 'react';
import { CanvasViewport } from './CanvasViewport';
import './Canvas.css';

/**
 * Canvas Mode surface. Rendered as a sibling of the tab-mode terminal container
 * and shown only when `canvas.enabled` — design 010 D1: this is a lens over the
 * same state, so the tab-mode DOM stays mounted underneath.
 */
export const CanvasMode: React.FC = () => (
  <div className="canvas-mode" data-testid="canvas-mode">
    <CanvasViewport />
  </div>
);

export default CanvasMode;
