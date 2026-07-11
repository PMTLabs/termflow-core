import React, { useState, useRef, useEffect } from 'react';
import './SplitButton.css';

export interface SplitOption {
  key: string;
  label: string;
}

interface SplitButtonProps {
  /** Main button label, e.g. "Stop". */
  label: string;
  /** Dropdown options shown behind the ▾ arrow. */
  options: SplitOption[];
  /** Key passed to onSelect when the main button (not the arrow) is clicked. */
  defaultKey: string;
  /** Fired with the chosen option key (main click → defaultKey). */
  onSelect: (key: string) => void;
  disabled?: boolean;
  /** Extra class on the wrapper for theming (e.g. "stop" / "start"). */
  variant?: string;
}

/**
 * A split / dropdown button: the main part runs the default action; the ▾ arrow
 * opens a menu to pick a specific variant. Used for Stop/Start (All / API / MCP).
 */
export const SplitButton: React.FC<SplitButtonProps> = ({
  label,
  options,
  defaultKey,
  onSelect,
  disabled = false,
  variant = '',
}) => {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  const choose = (key: string) => {
    setOpen(false);
    onSelect(key);
  };

  return (
    <div className={`split-button ${variant}`} ref={ref}>
      <button
        type="button"
        className="split-button-main"
        disabled={disabled}
        onClick={() => choose(defaultKey)}
      >
        {label}
      </button>
      <button
        type="button"
        className="split-button-arrow"
        disabled={disabled}
        aria-label={`${label} options`}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        ▾
      </button>
      {open && (
        <div className="split-button-menu" role="menu">
          {options.map((opt) => (
            <button
              key={opt.key}
              type="button"
              role="menuitem"
              className="split-button-item"
              onClick={() => choose(opt.key)}
            >
              {opt.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};
