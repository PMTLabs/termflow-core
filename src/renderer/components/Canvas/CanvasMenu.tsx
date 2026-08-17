import React, { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import '../Panes/PaneContextMenu.css';

/**
 * The shell every canvas menu shares: portalled, positioned, and dismissed the same way.
 *
 * There are four of them now — the wire menu (Task 18), the node menu, the canvas-background
 * menu and the port menu — and what they have in common is not the items but the two easy
 * things to get wrong:
 *
 * **The portal.** A menu rendered inside the canvas is trapped in `.canvas-world`'s stacking
 * context (it sets `will-change: transform`) and cannot paint above an overlaid node however
 * high its z-index. `canvasStacking.test.ts` enforces the rule; this is where it is obeyed.
 *
 * **The rAF before listening.** The very pointer event that opens a menu is still propagating
 * when the effect runs, so a listener attached synchronously sees it and closes the menu it
 * just opened — a menu that flickers and vanishes, with nothing in the code that looks wrong.
 *
 * Styling is borrowed from `PaneContextMenu.css` rather than duplicated; there is no generic
 * menu component in this repo, and this is deliberately not trying to be one — it owns
 * placement and dismissal, and nothing about what a menu contains.
 */
export const CanvasMenu: React.FC<{
  x: number;
  y: number;
  onClose: () => void;
  /** Extra class for menu-specific width/spacing tweaks. */
  className?: string;
  children: React.ReactNode;
}> = ({ x, y, onClose, className, children }) => {
  const ref = useRef<HTMLDivElement>(null);

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

  return createPortal(
    <div
      ref={ref}
      className={`pane-context-menu canvas-menu ${className ?? ''}`.trim()}
      style={{ left: x, top: y }}
      // Right-clicking the menu itself must not open the browser's own menu on top of it, and
      // must not reach the canvas underneath and open a SECOND canvas menu.
      onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); }}
    >
      {children}
    </div>,
    document.body,
  );
};

/** One row. Split out so the four menus cannot drift on markup — `context-menu-item` carries
 *  the hover/disabled styling, and a menu that hand-rolled its own button would lose it.
 *
 *  `danger` is styled in `Canvas.css` under `.canvas-menu`, not in `PaneContextMenu.css`: this
 *  borrows that stylesheet, it does not own it, and a rule added there would apply to the pane
 *  and tab menus that have no such item. */
export const CanvasMenuItem: React.FC<{
  /** A glyph or an <img>. Wide because a shell profile shows its real binary icon when the
   *  session has resolved one and an emoji when it has not. */
  icon?: React.ReactNode;
  onClick: () => void;
  danger?: boolean;
  children: React.ReactNode;
}> = ({ icon, onClick, danger, children }) => (
  <button
    className={`context-menu-item ${danger ? 'danger' : ''}`.trim()}
    onClick={onClick}
  >
    {icon && <span className="menu-icon">{icon}</span>}
    {children}
  </button>
);

export default CanvasMenu;
