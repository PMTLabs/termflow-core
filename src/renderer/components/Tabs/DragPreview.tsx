import React, { useEffect, useState } from 'react';
import ReactDOM from 'react-dom/client';
import { listen } from '@tauri-apps/api/event';
import './DragPreview.css';

/**
 * The content of the tear-off preview window (`index.html?dragPreview=1`). It is
 * a real OS window — frameless, transparent, click-through — that follows the
 * cursor during a tab drag, so the preview stays visible after the cursor leaves
 * the source window. The backend (`show_drag_preview`) refreshes the title via a
 * `drag-preview:title` event when the window is reused for a different tab.
 */
const DragPreviewCard: React.FC<{ initialTitle: string }> = ({ initialTitle }) => {
  const [title, setTitle] = useState(initialTitle);
  useEffect(() => {
    const un = listen<string>('drag-preview:title', (e) => setTitle(e.payload || 'Terminal'));
    return () => { void un.then((f) => f()); };
  }, []);
  return (
    <div className="drag-preview-window">
      <div className="drag-preview-window__bar">{title}</div>
      <div className="drag-preview-window__body" />
    </div>
  );
};

/** Mount the preview card. Called from the renderer entry for the preview window. */
export function renderDragPreview(initialTitle: string): void {
  document.documentElement.classList.add('drag-preview-root');
  document.body.classList.add('drag-preview-root');
  const container = document.getElementById('root');
  if (!container) return;
  ReactDOM.createRoot(container).render(<DragPreviewCard initialTitle={initialTitle} />);
}
