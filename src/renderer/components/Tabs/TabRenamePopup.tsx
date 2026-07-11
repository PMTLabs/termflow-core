import React, { useEffect, useRef, useState } from 'react';
import './TabRenamePopup.css';

interface TabRenamePopupProps {
  x: number;
  y: number;
  initialTitle: string;
  onSubmit: (title: string) => void;
  onClose: () => void;
}

/**
 * Floating rename popup, opened near the tab (not inline in the tab strip).
 * Inline editing broke down once tabs got narrow with many open — the input
 * had to squeeze into the tab's own width. This renders fixed-position with
 * a fixed full-length input so the user can always see/edit the whole name.
 */
export const TabRenamePopup: React.FC<TabRenamePopupProps> = ({
  x,
  y,
  initialTitle,
  onSubmit,
  onClose,
}) => {
  const [value, setValue] = useState(initialTitle);
  const popupRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // Guards against double-commit (e.g. Enter immediately followed by the
  // resulting blur/outside-click as focus moves away).
  const settledRef = useRef(false);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  // Edge-aware: shift left/up so the popup never spills past the right/bottom
  // edge when opened near one (same approach as TabContextMenu).
  useEffect(() => {
    const el = popupRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const adjustedX = Math.min(x, window.innerWidth - rect.width - 5);
    const adjustedY = Math.min(y, window.innerHeight - rect.height - 5);
    el.style.left = `${Math.max(5, adjustedX)}px`;
    el.style.top = `${Math.max(5, adjustedY)}px`;
  }, [x, y]);

  const commit = () => {
    if (settledRef.current) return;
    settledRef.current = true;
    const trimmed = value.trim();
    if (trimmed) onSubmit(trimmed);
    onClose();
  };

  const cancel = () => {
    if (settledRef.current) return;
    settledRef.current = true;
    onClose();
  };

  useEffect(() => {
    // Clicking outside commits the edit (matches the old inline input's
    // blur-to-save behavior); Escape (handled via onKeyDown below) discards.
    const handleClickOutside = (e: MouseEvent) => {
      if (popupRef.current && !popupRef.current.contains(e.target as Node)) {
        commit();
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancel();
    }
  };

  return (
    <div
      ref={popupRef}
      className="tab-rename-popup"
      style={{ left: x, top: y }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <input
        ref={inputRef}
        type="text"
        className="tab-rename-input"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={handleKeyDown}
      />
    </div>
  );
};
