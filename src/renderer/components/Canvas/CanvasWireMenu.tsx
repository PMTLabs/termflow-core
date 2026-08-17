import React, { useState } from 'react';
import { useDispatch } from 'react-redux';
import { CanvasEdge, removeEdge, updateEdge } from '../../store/slices/canvasSlice';
import { deleteEdge, patchEdgeLabel } from '../../services/canvasGraph';
import { CanvasMenu, CanvasMenuItem } from './CanvasMenu';

/**
 * Right-click menu for a connection — `plan/013` Task 18, design 010 D3.
 *
 * Without it the "optional user-typed label" is unreachable from the UI and a mis-drawn wire is
 * permanent. Placement, the portal and the dismiss rules live in `CanvasMenu`, which this was
 * the only implementation of until the node, background and port menus needed the same three
 * things; what is left here is only what a CONNECTION menu contains.
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
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(edge.label ?? '');

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

  return (
    <CanvasMenu x={x} y={y} onClose={onClose} className="canvas-wire-menu">
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
        <CanvasMenuItem icon="✏️" onClick={() => setRenaming(true)}>
          {edge.label ? 'Rename Connection…' : 'Label Connection…'}
        </CanvasMenuItem>
      )}
      <div className="context-menu-divider" />
      <CanvasMenuItem icon="🗑️" onClick={remove}>Delete Connection</CanvasMenuItem>
    </CanvasMenu>
  );
};

export default CanvasWireMenu;
