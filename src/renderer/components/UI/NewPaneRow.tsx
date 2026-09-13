import React from 'react';
import './NewPaneRow.css';

export type NewPaneDirection = 'vertical' | 'horizontal';
export type NewPanePosition = 'before' | 'after';

export interface NewPaneRowProps {
  onSplit: (direction: NewPaneDirection, position: NewPanePosition) => void;
  onDone: () => void;
  disabled?: boolean;
  title?: string;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
  onFocus?: () => void;
  onBlur?: () => void;
}

const directions = [
  { icon: '➡️', label: 'Right', direction: 'vertical' as const, position: 'after' as const },
  { icon: '⬇️', label: 'Bottom', direction: 'horizontal' as const, position: 'after' as const },
  { icon: '⬅️', label: 'Left', direction: 'vertical' as const, position: 'before' as const },
  { icon: '⬆️', label: 'Up', direction: 'horizontal' as const, position: 'before' as const },
];

export const NewPaneRow: React.FC<NewPaneRowProps> = ({
  onSplit,
  onDone,
  disabled = false,
  title,
  onMouseEnter,
  onMouseLeave,
  onFocus,
  onBlur,
}) => {
  const activate = (direction: NewPaneDirection, position: NewPanePosition) => {
    try {
      onSplit(direction, position);
    } finally {
      onDone();
    }
  };

  return (
    <div
      className={`context-menu-item new-pane-row${disabled ? ' is-disabled' : ''}`}
      title={title}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      onFocus={onFocus}
      onBlur={onBlur}
      onClick={() => {
        if (!disabled) activate('vertical', 'after');
      }}
    >
      <button
        type="button"
        className="new-pane-row-main"
        aria-label="New pane right"
        disabled={disabled}
      >
        <span className="new-pane-row-icon">➡️</span>
        <span className="new-pane-row-label">New Pane</span>
      </button>
      <div className="new-pane-row-actions">
        {directions.map(({ icon, label, direction, position }) => (
          <button
            key={label}
            type="button"
            className="new-pane-row-action"
            title={`New pane ${label.toLowerCase()}`}
            aria-label={`New pane ${label.toLowerCase()}`}
            disabled={disabled}
            onClick={(e) => {
              e.stopPropagation();
              activate(direction, position);
            }}
          >
            {icon}
          </button>
        ))}
      </div>
    </div>
  );
};
