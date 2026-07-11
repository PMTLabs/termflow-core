import React, { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import './ContextMenu.css';

interface ContextMenuItem {
  label?: string;
  icon?: string;
  accelerator?: string;
  /** Hover tooltip explaining what the item does. */
  title?: string;
  type?: 'normal' | 'separator';
  enabled?: boolean;
  click?: () => void;
}

interface ContextMenuProps {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
}

export const ContextMenu: React.FC<ContextMenuProps> = ({ x, y, items, onClose }) => {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };

    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleEscape);

    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [onClose]);

  // Adjust position to keep menu on screen
  useEffect(() => {
    if (menuRef.current) {
      const rect = menuRef.current.getBoundingClientRect();
      const adjustedX = Math.min(x, window.innerWidth - rect.width - 5);
      const adjustedY = Math.min(y, window.innerHeight - rect.height - 5);
      
      menuRef.current.style.left = `${Math.max(5, adjustedX)}px`;
      menuRef.current.style.top = `${Math.max(5, adjustedY)}px`;
    }
  }, [x, y]);

  // Portal to <body> so the menu floats above the terminal and is never clipped
  // by a pane ancestor's `overflow: hidden` / stacking context — and so
  // `position: fixed` is measured against the viewport (correct edge-aware math).
  return createPortal(
    <div
      ref={menuRef}
      className="context-menu"
      style={{ left: x, top: y }}
    >
      {items.map((item, index) => {
        if (item.type === 'separator') {
          return <div key={index} className="context-menu-separator" />;
        }

        return (
          <button
            key={index}
            className="context-menu-item"
            disabled={item.enabled === false}
            title={item.title}
            onClick={() => {
              item.click?.();
              onClose();
            }}
          >
            <span className="context-menu-icon">{item.icon}</span>
            <span className="context-menu-label">{item.label}</span>
            {item.accelerator && (
              <span className="context-menu-accelerator">{item.accelerator}</span>
            )}
          </button>
        );
      })}
    </div>,
    document.body
  );
};