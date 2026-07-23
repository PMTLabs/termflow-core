import React from 'react';

/**
 * Monochrome bell / bell-with-slash icon (inherits `currentColor`). When
 * `muted` is true it draws a diagonal slash across the bell (the universal
 * "notifications off" glyph). Kept as a single component so the pane header,
 * both context menus, and the tab-bar indicator all render an identical,
 * dependency-free bell (the codebase uses inline SVGs, no icon library).
 */
export const BellIcon: React.FC<{ muted?: boolean; size?: number; className?: string }> = ({
  muted = false,
  size = 14,
  className,
}) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 16 16"
    aria-hidden="true"
    className={className}
  >
    <path
      d="M8 1.75A3.25 3.25 0 0 0 4.75 5c0 2.2-.55 3.62-1.16 4.48-.3.42.02 1.02.53 1.02h7.76c.51 0 .83-.6.53-1.02C11.8 8.62 11.25 7.2 11.25 5A3.25 3.25 0 0 0 8 1.75z"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.2"
      strokeLinejoin="round"
    />
    <path
      d="M6.5 12.4a1.5 1.5 0 0 0 3 0"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.2"
    />
    {muted && (
      <line
        x1="2.6"
        y1="2.6"
        x2="13.4"
        y2="13.4"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
    )}
  </svg>
);
