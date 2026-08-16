import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useDispatch } from 'react-redux';
import { CanvasEdge, removeEdge, updateEdge } from '../../store/slices/canvasSlice';
import { deleteEdge, patchEdgeLabel } from '../../services/canvasGraph';
import '../Panes/PaneContextMenu.css';

/**
 * Right-click menu for a connection — `plan/013` Task 18, design 010 D3.
 *
 * Without it the "optional user-typed label" is unreachable from the UI and a mis-drawn wire is
 * permanent. Reuses `PaneContextMenu.css`'s item/divider/header classes rather than growing a
 * second menu stylesheet; there is no generic menu COMPONENT in this repo to reuse — every menu
 * is bespoke — so what is shared is the styling and the portal.
 *
 * Portalled to `document.body`, which is the rule `canvasStacking.test.ts` enforces: a menu
 * rendered inside the canvas would be trapped in `.canvas-world`'s stacking context (it sets
 * `will-change: transform`) and could not paint above an overlaid node however high its z-index.
 *
 * The rename is an inline input, never `window.prompt`: a modal dialog blocks the event loop and
 * would strand the pointer capture the wire drag may still hold.
 */
export const CanvasWireMenu: React.FC<{
  x: number;
  y: number;
  edge: CanvasEdge;
  /** Edge endpoints as titles, for a header that says which connection this is. */
  fromTitle: string;
  toTitle: string;
  onClose: () => void;
}> = ({ x, y, edge, fromTitle, toTitle, onClose }) => {
  const dispatch = useDispatch();
  const ref = useRef<HTMLDivElement>(null);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(edge.label ?? '');

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    // A frame late, or the very click that opened the menu closes it again.
    const id = requestAnimationFrame(() => {
      window.addEventListener('mousedown', onDown);
      window.addEventListener('keydown', onKey);
    });
    return () => {
      cancelAnimationFrame(id);
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const commitLabel = () => {
    const trimmed = draft.trim();
    const label = trimmed.length ? trimmed : null;
    onClose();
    if (label === (edge.label ?? null)) return;
    // Write the row the SERVER returns, never the draft: a failed PATCH must leave the wire
    // showing its real label rather than one only this window believes in.
    void patchEdgeLabel(edge.id, label).then((updated) => {
      if (updated) dispatch(updateEdge(updated));
    });
  };

  const remove = () => {
    onClose();
    void deleteEdge(edge.id).then((ok) => {
      if (ok) dispatch(removeEdge(edge.id));
    });
  };

  return createPortal(
    <div
      ref={ref}
      className="pane-context-menu canvas-wire-menu"
      style={{ left: x, top: y }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="context-menu-header">{fromTitle} → {toTitle}</div>
      <div className="context-menu-divider" />
      {renaming ? (
        <input
          className="canvas-wire-label-input"
          autoFocus
          value={draft}
          placeholder="Label this connection"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitLabel();
            if (e.key === 'Escape') { e.stopPropagation(); onClose(); }
          }}
          onBlur={commitLabel}
        />
      ) : (
        <button className="context-menu-item" onClick={() => setRenaming(true)}>
          <span className="menu-icon">✏️</span>
          {edge.label ? 'Rename Connection…' : 'Label Connection…'}
        </button>
      )}
      <div className="context-menu-divider" />
      <button className="context-menu-item" onClick={remove}>
        <span className="menu-icon">🗑️</span>
        Delete Connection
      </button>
    </div>,
    document.body,
  );
};

export default CanvasWireMenu;
