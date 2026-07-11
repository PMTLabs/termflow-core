import React, { useLayoutEffect, useRef, useState } from 'react';
import { placePopup, PopupAnchor } from './suggestLogic';
import './CommandSuggestPopup.css';

export interface CommandSuggestPopupProps {
  suggestions: string[];
  selectedIndex: number;
  focused: boolean;
  anchor: PopupAnchor | null;
  onPick: (command: string) => void;
}

/** History-suggestion popup (backlog 011). Anchored near the terminal cursor;
 *  keyboard interaction is handled by the engine (see onSuggestAction) — this
 *  component only renders state and handles mouse picks. */
export const CommandSuggestPopup: React.FC<CommandSuggestPopupProps> = ({
  suggestions,
  selectedIndex,
  focused,
  anchor,
  onPick,
}) => {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  // Full text of the focused item when it is visually truncated (ellipsis) —
  // rendered as a tooltip band above/below the popup. null = no tooltip.
  const [tooltip, setTooltip] = useState<string | null>(null);

  // Measure after render, then place (and flip/clamp) within the pane.
  useLayoutEffect(() => {
    const el = ref.current;
    const parent = el?.offsetParent as HTMLElement | null;
    if (!el || !parent) return;
    setPos(placePopup(anchor, el.offsetWidth, el.offsetHeight, parent.clientWidth, parent.clientHeight));
  }, [anchor, suggestions]);

  // Keep the selected row visible when navigating a long list, and show the
  // full text as a tooltip when the focused row is truncated.
  useLayoutEffect(() => {
    const selected = ref.current?.querySelector('.csp-selected') as HTMLElement | null;
    selected?.scrollIntoView({ block: 'nearest' });
    if (focused && selected && selected.scrollWidth > selected.clientWidth) {
      setTooltip(suggestions[selectedIndex] ?? null);
    } else {
      setTooltip(null);
    }
  }, [selectedIndex, focused, suggestions]);

  return (
    <div
      ref={ref}
      className={`command-suggest-popup${focused ? ' csp-focused' : ''}`}
      style={pos ? { left: pos.left, top: pos.top } : { visibility: 'hidden' }}
      role="listbox"
      aria-label="Command history suggestions"
    >
      <div className="csp-list">
        {suggestions.map((s, i) => (
          <div
            key={`${i}-${s}`}
            role="option"
            aria-selected={i === selectedIndex}
            className={`csp-item${i === selectedIndex ? ' csp-selected' : ''}`}
            title={s}
            // mousedown (not click) so the terminal never loses focus mid-pick.
            onMouseDown={(e) => {
              e.preventDefault();
              onPick(s);
            }}
          >
            {s}
          </div>
        ))}
      </div>
      {tooltip && (
        <div className="csp-tooltip" role="tooltip">
          {tooltip}
        </div>
      )}
      <div className="csp-hint">
        {focused
          ? 'Enter insert · Shift+Del remove · Esc back'
          : 'Shift+Enter insert · ↓ focus · Esc dismiss'}
      </div>
    </div>
  );
};
