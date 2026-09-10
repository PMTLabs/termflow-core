import React, { useEffect, useState } from 'react';
import ReactDOM from 'react-dom/client';
import { listen } from '@tauri-apps/api/event';
import { titleColorStyle } from '../../store/titleColor';
import './DragPreview.css';

/**
 * The content of the tear-off preview window (`index.html?dragPreview=1`). It is
 * a real OS window — frameless, transparent, click-through — that follows the
 * cursor during a tab drag, so the preview stays visible after the cursor leaves
 * the source window. The backend (`show_drag_preview`) refreshes the title via a
 * `drag-preview:title` event when the window is reused for a different tab.
 *
 * The tab's colour arrives by BOTH routes, deliberately: as a query param when this window is
 * first created, and in the event payload when an existing window is reused for another tab.
 * Wiring only one would leave either the first drag of a session or every subsequent one showing
 * the wrong colour — and which half broke would depend on drag order, so it would look flaky.
 * This is a separate renderer with its own store, so the colour can only arrive as data.
 */
interface PreviewTitle { title: string; color?: string | null }

const DragPreviewCard: React.FC<{ initialTitle: string; initialColor?: string }> = ({
  initialTitle, initialColor,
}) => {
  const [title, setTitle] = useState(initialTitle);
  const [color, setColor] = useState<string | undefined>(initialColor);
  useEffect(() => {
    const un = listen<PreviewTitle>('drag-preview:title', (e) => {
      setTitle(e.payload?.title || 'Terminal');
      setColor(e.payload?.color || undefined);
    });
    return () => { void un.then((f) => f()); };
  }, []);
  return (
    <div className="drag-preview-window">
      <div className="drag-preview-window__bar" style={titleColorStyle(color)}>{title}</div>
      <div className="drag-preview-window__body" />
    </div>
  );
};

/** Mount the preview card. Called from the renderer entry for the preview window. */
export function renderDragPreview(initialTitle: string, initialColor?: string): void {
  document.documentElement.classList.add('drag-preview-root');
  document.body.classList.add('drag-preview-root');
  const container = document.getElementById('root');
  if (!container) return;
  ReactDOM.createRoot(container).render(
    <DragPreviewCard initialTitle={initialTitle} initialColor={initialColor} />,
  );
}
