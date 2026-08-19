import React, { useState } from 'react';
import { renameTab } from '../../services/renameTab';
import { CanvasMenu, CanvasMenuItem } from './CanvasMenu';

/**
 * Right-click menu for a group — the canvas half of "rename a group".
 *
 * A group IS a tab (design 010 §2.1), so this renames a tab, and it goes through `renameTab`
 * rather than dispatching a title: the tab strip's rename also names every live pane process and
 * saves, and a menu that only wrote the store title would leave the canvas label and the process
 * list disagreeing.
 *
 * **Why a menu rather than a double-click on the label.** The label already owns a gesture — it
 * is the drag handle for moving the whole group — and `onGroupLabelPointerDown` calls
 * `preventDefault()`, which suppresses the click and double-click that would follow. Reaching
 * the rename through a double-click therefore means reworking that drag, and `useSidebarDrag`
 * documents what the `preventDefault` is holding back. A `contextmenu` is unaffected by it.
 *
 * The rename is an inline input, never `window.prompt`: a modal dialog blocks the event loop and
 * would strand the pointer capture a group drag may still hold — the same reason `CanvasWireMenu`
 * gives for its label box.
 */
export const CanvasGroupMenu: React.FC<{
  x: number;
  y: number;
  tabId: string;
  /** The group's current title, which is its tab's — both the header and the box's seed. */
  title: string;
  onClose: () => void;
}> = ({ x, y, tabId, title, onClose }) => {
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(title);

  const commit = () => {
    onClose();
    // `renameTab` refuses a blank name itself, so a cleared box committed on blur is a cancel
    // rather than a tab called '' — see the note there.
    void renameTab(tabId, draft);
  };

  return (
    <CanvasMenu x={x} y={y} onClose={onClose} className="canvas-group-menu">
      <div className="context-menu-header">{title}</div>
      <div className="context-menu-divider" />
      {renaming ? (
        <input
          className="canvas-group-name-input"
          autoFocus
          value={draft}
          placeholder="Name this group"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); commit(); }
            // Stopped here, or the canvas Escape handler behind this one also unfocuses the
            // terminal — a cancelled rename would quietly do a second, unrelated thing.
            if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); }
          }}
          onBlur={commit}
        />
      ) : (
        <CanvasMenuItem icon="✏️" onClick={() => setRenaming(true)}>Rename Group…</CanvasMenuItem>
      )}
    </CanvasMenu>
  );
};

export default CanvasGroupMenu;
