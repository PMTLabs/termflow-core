import React from 'react';
import { useSubmenuEdgeFlip } from '../../hooks/useSubmenuEdgeFlip';
import './SubmenuFlyoutHost.css';

export interface SubmenuFlyoutHostProps {
  /** Whether the panel is currently open. Owned by the caller (a single-slot
   *  `openSubmenu` state, mirroring `ContextMenu`'s), not by this component. */
  open: boolean;
  /** The row that opens the panel — usually a `<button className="context-menu-item">`
   *  wired to the caller's own hover-debounce/click-open handlers. */
  trigger: React.ReactNode;
  /** Panel content, mounted only while `open`. */
  children: React.ReactNode;
  /** Extra class(es) on the panel itself — e.g. `submenu-flyout-panel--wide` for a submenu
   *  whose content (a swatch grid) needs more room than the others in the same menu. */
  panelClassName?: string;
  /** Re-entering the host (trigger OR panel) cancels a pending close, the same
   *  "coming back from a neighbour" backstop `ContextMenu`'s submenu host relies on. */
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
}

/**
 * A flyout submenu host for a hand-rolled context menu, styled and positioned to match the
 * terminal's own (`ContextMenu.tsx` / `ContextMenu.css`'s `.context-menu-flyout`) — a side
 * panel rather than an inline accordion. Deliberately lighter than that component: no search
 * box, no row list, no arrow-key navigation — just the position/edge-flip mechanics (shared
 * with `ContextMenu.tsx`'s own submenu panels via `useSubmenuEdgeFlip`), so a caller can drop
 * arbitrary widget content (a swatch grid, a profile list) into the panel. The hover-open
 * debounce and hover-close grace live in the CALLER, so every submenu in the same menu shares
 * one timer pair and only one flyout is ever open at a time.
 */
export const SubmenuFlyoutHost: React.FC<SubmenuFlyoutHostProps> = ({
  open,
  trigger,
  children,
  panelClassName,
  onMouseEnter,
  onMouseLeave,
}) => {
  const { panelRef, flip } = useSubmenuEdgeFlip(open, [children]);

  return (
    <div className="submenu-flyout-host" onMouseEnter={onMouseEnter} onMouseLeave={onMouseLeave}>
      {trigger}
      {open && (
        <div
          ref={panelRef}
          className={`submenu-flyout-panel${flip.left ? ' flip-left' : ''}${panelClassName ? ` ${panelClassName}` : ''}`}
          style={flip.shiftY ? { top: flip.shiftY } : undefined}
          // A right-click inside the panel is swallowed rather than raising the native
          // WebView2 menu over it — the same call `ContextMenu`'s own flyout panel makes.
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
          }}
        >
          {children}
        </div>
      )}
    </div>
  );
};
