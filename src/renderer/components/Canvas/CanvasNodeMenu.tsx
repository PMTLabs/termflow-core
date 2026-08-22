import React from 'react';
import { CanvasMenu, CanvasMenuItem } from './CanvasMenu';

/**
 * Right-click menu for a terminal node (Tam, 2026-08-21).
 *
 * It shipped with one item — Close Terminal — which made the node's most destructive action the
 * only one the menu offered. The two non-destructive ways out of the overview already existed as
 * header buttons; they were simply unreachable from the gesture people try first.
 *
 * **The labels are the header buttons' own tooltips, verbatim** (`CanvasNode`), and that is the
 * point rather than a coincidence. One action reached two ways must be named one way, or the
 * menu teaches a second vocabulary for the same three controls.
 *
 * On Tam's "suggest a better word than close" for the overlay: **Shrink back to the canvas**.
 * `✕ Close Terminal` sits two rows below it and means *kill this shell*; a second "close" in the
 * same menu, meaning *change the size of a window*, is the exact ambiguity `canvasCloseWiring`
 * already policed the ✕ glyph for. Shrink says what happens, and it is the word the ⤡ button has
 * used since that fix.
 *
 * Its own component, like `CanvasGroupMenu` and `CanvasWireMenu`, rather than JSX inlined in
 * `CanvasMode`: that file is ~1200 lines, and a menu inlined there can only be tested by reading
 * its source. Pure and props-only, so its label/state table is a render test.
 */
export const CanvasNodeMenu: React.FC<{
  x: number;
  y: number;
  /** The terminal's own title — `PaneNode.name`, the same string the node header shows. */
  title: string;
  /**
   * True while THIS node is the overlay. Swaps the enlarge item for its shrink face.
   *
   * REQUIRED, not defaulted. A default would keep the menu compiling while it offered "Enlarge"
   * on a node already filling the screen — an item that looks live, and whose only effect is to
   * toggle the overlay shut under a label that promised the opposite.
   */
  overlaid: boolean;
  /** Enlarge, or shrink back — one handler, because it is one toggle (see `CanvasNode`). */
  onToggleOverlay: () => void;
  /** Leave the canvas for this terminal's own tab. */
  onOpenAsTab: () => void;
  /** Close the terminal. Routed through the app's pane/tab close flows by the caller. */
  onCloseTerminal: () => void;
  /** Dismiss the menu without doing anything. */
  onDismiss: () => void;
}> = ({ x, y, title, overlaid, onToggleOverlay, onOpenAsTab, onCloseTerminal, onDismiss }) => (
  <CanvasMenu x={x} y={y} onClose={onDismiss}>
    <div className="context-menu-header">{title}</div>
    <div className="context-menu-divider" />
    {/* The glyphs are the header buttons' too, and they are sizing glyphs in BOTH states —
        never ✕, which one row below this means "kill this shell". */}
    <CanvasMenuItem
      icon={overlaid ? '⤡' : '⛶'}
      onClick={() => { onDismiss(); onToggleOverlay(); }}
    >
      {overlaid ? 'Shrink back to the canvas' : 'Enlarge on the canvas'}
    </CanvasMenuItem>
    <CanvasMenuItem
      icon="⧉"
      onClick={() => { onDismiss(); onOpenAsTab(); }}
    >
      Open in its tab
    </CanvasMenuItem>
    {/* Separated and LAST, for the reason the close button is last in the header: the
        destructive item must not sit where a click aimed at either one above it can land. */}
    <div className="context-menu-divider" />
    <CanvasMenuItem
      icon="✕"
      danger
      onClick={() => { onDismiss(); onCloseTerminal(); }}
    >
      Close Terminal
    </CanvasMenuItem>
  </CanvasMenu>
);

export default CanvasNodeMenu;
